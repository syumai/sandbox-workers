my @words = $input->{text} =~ /\b\w+\b/g;
my %counts;
$counts{lc $_}++ for @words;
print "Parsed ", scalar(@words), " words\n";
return \%counts;
